import ChatWindow from '@/components/ChatWindow';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: "Dorian's Perplexica",
  description: 'Chat with the internet, chat with Perplexica.',
};

const Home = () => {
  return <ChatWindow />;
};

export default Home;
